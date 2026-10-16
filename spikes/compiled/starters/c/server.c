// Minimal HTTP/1.1 JSON server using POSIX sockets and pthreads (WASIX provides both).
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static atomic_ulong hits;

static void write_all(int fd, const char *buf, int len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n <= 0) return;
    buf += n;
    len -= n;
  }
}

// One detached thread per connection so a slow client cannot stall the others.
static void *handle(void *arg) {
  int c = (int)(long)arg;
  char req[2048];
  read(c, req, sizeof req);
  char body[160], res[400];
  int blen = snprintf(body, sizeof body, "{\"lang\":\"c\",\"runtime\":\"wasix\",\"hits\":%lu}", ++hits);
  int rlen = snprintf(res, sizeof res,
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
      blen, body);
  write_all(c, res, rlen);
  close(c);
  return NULL;
}

int main(void) {
  const char *env = getenv("PORT");
  int port = env ? atoi(env) : 8080;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { perror("socket"); return 1; }
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(port) };
// Loopback only: with network host mode the guest's bind becomes a real host listener,
  // and 0.0.0.0 would expose it on every host interface.
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0) { perror("bind"); return 1; }
  if (listen(fd, 128) < 0) { perror("listen"); return 1; }
  printf("listening on %d\n", port);
  fflush(stdout);
  for (;;) {
    int c = accept(fd, NULL, NULL);
    if (c < 0) { perror("accept"); continue; }
    pthread_t t;
    if (pthread_create(&t, NULL, handle, (void *)(long)c) != 0) { close(c); continue; }
    pthread_detach(t);
  }
}
