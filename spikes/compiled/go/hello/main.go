package main

import (
	"fmt"
	"runtime"
)

func main() {
	fmt.Printf("hello from Go %s (%s/%s) inside a Wasmer sandbox\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
}
