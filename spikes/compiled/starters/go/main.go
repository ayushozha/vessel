// Standard net/http server on GOOS=wasip1, running on Wasmer.
//
// Stock wasip1 Go cannot bind sockets, but Wasmer implements the WASIX
// socket syscalls. We open/bind/listen through them, then hand the fd to
// net.FileListener, which accepts via the standard WASI sock_accept.
package main

import (
	"encoding/json"
	"fmt"

	"net/http"
	"os"
	"strconv"
	"sync/atomic"
)

func main() {
	port, err := strconv.Atoi(os.Getenv("PORT"))
	if err != nil {
		port = 8080
	}
	ln, err := listenTCP(uint16(port))
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	var hits atomic.Int64
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"lang": "go", "runtime": "wasip1+wasix-sockets", "hits": hits.Add(1)})
	})
	fmt.Println("listening on", port)
	if err := http.Serve(ln, nil); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(1)
	}
}
