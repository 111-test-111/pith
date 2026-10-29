def double(values):
    total = 0
    for v in values:
        total += v * 2  # breakpoint: line 4 — v == 1 on first stop
    return total


if __name__ == "__main__":
    print(double([1, 2, 3]))
