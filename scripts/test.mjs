#!/usr/bin/env node
import { suites } from './tests/manifest.mjs'
import { main } from './tests/runner.mjs'

process.exitCode = await main({ suites })
