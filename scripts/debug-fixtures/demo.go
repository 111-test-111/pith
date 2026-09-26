package main

import "fmt"

func add(a, b int) int {
	return a + b // breakpoint: line 6 — a == 2 on first stop
}

func main() {
	fmt.Println(add(2, 3))
}
