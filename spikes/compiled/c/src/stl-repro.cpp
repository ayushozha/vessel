// Repro: libc++ containers (via <atomic>) hang in-sandbox clang/clang 16. Run: node c/spike.mjs --stl-repro
#include <iostream>
#include <string>
#include <vector>
int main() {
  std::vector<std::string> parts{"hello", "from", "C++", "inside", "Wasmer"};
  std::string line;
  for (const auto &p : parts) line += p + " ";
  std::cout << line << std::endl;
}
