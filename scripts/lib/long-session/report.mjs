const median = sorted => sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2

export function aggregate(samples) {
  const metrics = {}
  for (const phase of ['node', 'renderer']) {
    for (const key of Object.keys(samples[0][phase].metrics)) {
      const values = samples.map(sample => sample[phase].metrics[key])
      if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`Invalid measurement: ${phase}.${key}`)
      const sorted = [...values].sort((a, b) => a - b)
      metrics[`${phase}.${key}`] = { unit: 'ms', samples: values, min: sorted[0],
        median: median(sorted), p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], max: sorted.at(-1) }
    }
  }
  return metrics
}

export function compareReports(report, baseline, { maxRegression, minDeltaMs, baselinePath }) {
  if (baseline.passed !== true || baseline.schemaVersion !== report.schemaVersion || baseline.benchmark !== report.benchmark || baseline.workloadVersion !== report.workloadVersion || baseline.failures?.length) throw new Error('Baseline must be a successful report with the same schema/workload')
  if (!baseline.cases?.length || baseline.cases.some(item => item.complete !== true || !item.samples?.length)) throw new Error('Baseline contains incomplete or missing samples')
  for (const key of ['platform', 'arch', 'osRelease', 'cpuModel', 'logicalCpus', 'totalMemoryBytes', 'node']) {
    if (baseline.machine?.[key] !== report.machine[key]) throw new Error(`Baseline environment mismatch: ${key}`)
  }
  if (baseline.sdkVersion !== report.sdkVersion) throw new Error('Baseline SDK version mismatch')
  for (const key of ['rendererBuild', 'reducedMotion', 'appearance']) if (baseline.config?.[key] !== report.config[key]) throw new Error(`Baseline configuration mismatch: ${key}`)
  if (JSON.stringify(baseline.config?.viewport) !== JSON.stringify(report.config.viewport)) throw new Error('Baseline viewport mismatch')
  const comparisons = []
  for (const current of report.cases) {
    const previous = baseline.cases?.find(item => item.turns === current.turns)
    if (!previous || previous.workload.sha256 !== current.workload.sha256) throw new Error(`Baseline workload mismatch: ${current.turns} turns`)
    if (previous.samples[0].renderer.runtime.electron !== current.samples[0].renderer.runtime.electron || previous.samples[0].renderer.runtime.chrome !== current.samples[0].renderer.runtime.chrome) throw new Error('Baseline Electron/Chromium mismatch')
    for (const [name, metric] of Object.entries(current.metrics)) {
      const reference = previous.metrics?.[name]?.median
      if (!Number.isFinite(reference) || reference <= 0) throw new Error(`Baseline missing positive metric: ${name}`)
      const ratio = metric.median / reference, deltaMs = metric.median - reference
      comparisons.push({ turns: current.turns, metric: name, baselineMedianMs: reference, currentMedianMs: metric.median,
        ratio, deltaMs, passed: ratio <= maxRegression || deltaMs < minDeltaMs })
    }
  }
  return { baseline: baselinePath, maxRegression, minDeltaMs,
    rule: 'Fail when current median exceeds the ratio and the absolute delta reaches the noise floor. No universal wall-clock SLA.',
    passed: comparisons.every(item => item.passed), metrics: comparisons }
}
