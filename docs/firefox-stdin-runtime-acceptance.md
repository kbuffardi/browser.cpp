# Firefox buffered stdin runtime acceptance

Use this procedure to prove GitHub issue #53 is fixed in a real Firefox
extension context. `npm run test:browser:firefox` validates packaging and
manifest compatibility, but it does not execute a compiled program in Firefox.

## Setup

1. Run:

   ```bash
   npm run build
   npm run test:browser:firefox
   ```

2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Choose **Load Temporary Add-on** and select `dist-firefox/manifest.json`.
   For release validation, repeat with the signed XPI under
   `release/firefox-unlisted/`.
4. Open browser.cpp from the extension toolbar action.

Record the Firefox version and the unpacked directory or signed XPI path used.

## Test program

Replace the editor contents with exactly:

```cpp
#include <iostream>
#include <string>

int main() {
    std::string name;
    int age = 0;

    std::cout << "Name? ";
    std::cin >> name;
    std::cout << "Age? ";
    std::cin >> age;

    if (!std::cin) {
        std::cerr << "input failed\n";
        return 2;
    }

    std::cout << "\nHello " << name << ", next year " << (age + 1) << "\n";
    return 0;
}
```

Choose **Compile and Run**. In the **Pre-supplied stdin** dialog, enter exactly:

```text
Ada
41
```

Keep the final newline after `41`, then choose **Run program**.

## Expected result

The process exits with code `0`, stderr is empty, and stdout is exactly:

```text
Name? Age?␠
Hello Ada, next year 42
```

The `␠` marker represents the single trailing ASCII space emitted after
`Age?`.

The terminal and browser console must not contain any of these strings:

```text
Interactive stdin requires SharedArrayBuffer
Cross-Origin-Opener-Policy
Cross-Origin-Embedder-Policy
```

## PR evidence

Paste the following into the pull request:

- Firefox version
- tested artifact path
- observed stdout
- confirmation that stderr was empty
- confirmation that none of the old SharedArrayBuffer/COOP/COEP errors appeared
