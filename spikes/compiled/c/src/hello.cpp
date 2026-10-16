#include <cstdio>
#include <utility>

struct Greeter {
  const char *who;
  template <typename F> void greet(F &&decorate) const { std::printf("%s\n", decorate(who)); }
};

int main() {
  Greeter{"hello from C++, compiled and run inside a Wasmer sandbox"}.greet([](const char *s) { return s; });
}
