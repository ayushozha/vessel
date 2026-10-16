// C++ HTTP JSON server compiled by clang inside the Wasmer sandbox.
// Uses classes, RAII, templates and lambdas, but no libc++ containers:
// headers that pull in <atomic> (string, vector, memory, ...) hang the
// in-sandbox clang/clang 16 build (see docs/compiled-languages.md), so the
// hit counter uses the C11 atomic builtin instead.
#include <arpa/inet.h>
#include <cstdio>
#include <cstdlib>
#include <netinet/in.h>
#include <pthread.h>
#include <sys/socket.h>
#include <unistd.h>
#include <utility>

class Fd {
 public:
  explicit Fd(int fd) : fd_(fd) {}
  Fd(Fd &&o) noexcept : fd_(std::exchange(o.fd_, -1)) {}
  ~Fd() { if (fd_ >= 0) close(fd_); }
  int get() const { return fd_; }
  int release() { return std::exchange(fd_, -1); }
 private:
  int fd_;
};

static unsigned long hits = 0;

static void writeAll(int fd, const char *buf, int len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n <= 0) return;
    buf += n;
    len -= n;
  }
}

static void respond(const Fd &client) {
  char req[2048];
  if (read(client.get(), req, sizeof req) < 0) return;
  char body[128], res[384];
  unsigned long n = __atomic_add_fetch(&hits, 1, __ATOMIC_RELAXED);
  int blen = std::snprintf(body, sizeof body, "{\"lang\":\"cpp\",\"runtime\":\"wasix\",\"hits\":%lu}", n);
  int rlen = std::snprintf(res, sizeof res,
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", blen, body);
  writeAll(client.get(), res, rlen);
}

template <void (*Handler)(const Fd &)>
int serve(int port) {
  Fd server(socket(AF_INET, SOCK_STREAM, 0));
  int one = 1;
  setsockopt(server.get(), SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
// Loopback only: with network host mode the guest's bind becomes a real host listener,
  // and 0.0.0.0 would expose it on every host interface.
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(server.get(), reinterpret_cast<sockaddr *>(&addr), sizeof addr) < 0 || listen(server.get(), 128) < 0) {
    std::perror("bind/listen");
    return 1;
  }
  std::printf("listening on %d\n", port);
  std::fflush(stdout);
  for (;;) {
    Fd client(accept(server.get(), nullptr, nullptr));
    if (client.get() < 0) continue;
    // One detached thread per connection (WASIX pthreads); the thread owns the fd.
    pthread_t t;
    auto run = [](void *fd) -> void * { Handler(Fd(static_cast<int>(reinterpret_cast<long>(fd)))); return nullptr; };
    if (pthread_create(&t, nullptr, run, reinterpret_cast<void *>(static_cast<long>(client.get()))) == 0) {
      client.release();
      pthread_detach(t);
    }
  }
}

int main() {
  const char *env = std::getenv("PORT");
  return serve<respond>(env ? std::atoi(env) : 8080);
}
