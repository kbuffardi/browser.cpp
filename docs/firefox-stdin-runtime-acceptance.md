# Firefox stdin runtime acceptance

Use this procedure to validate live JSPI terminal input from GitHub issue #55
in a real Firefox extension context. `npm run test:browser:firefox` validates
packaging and manifest compatibility, but does not execute a compiled program.

Firefox 153+ should use live, canonical (line-buffered) input. Firefox 140–152,
or a runtime where JSPI is unavailable, should keep the pre-supplied buffered
fallback. Persistent folder write-back is outside this test and retains its
documented Firefox limitations.

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
4. Open browser.cpp from the extension toolbar action and open the Browser
   Console for error inspection.

Record the exact Firefox version and unpacked directory or signed XPI path.

## Live-input test for Firefox 153+

Replace the editor contents with:

```cpp
#include <iostream>
#include <string>

int main() {
    std::string name;
    int age = 0;

    std::cout << "Name? " << std::flush;
    std::getline(std::cin, name);
    std::cout << "Age? " << std::flush;
    std::cin >> age;

    if (!std::cin) {
        std::cerr << "input failed\n";
        return 2;
    }

    std::cout << "Hello " << name << ", next year " << (age + 1) << "\n";
}
```

1. Choose **Compile and Run**.
2. Confirm `Name? ` appears before entering anything and that the
   **Pre-supplied stdin** dialog does not open.
3. Type `Ada`, press Enter, and confirm `Age? ` appears afterward.
4. Type `41` and press Enter.
5. Confirm the final line is `Hello Ada, next year 42` and the process exits
   with code `0` without stderr.

This validates two independent suspend/resume cycles and prompt ordering.

## EOF, interruption, and clean-session tests

1. Run the program again. At the empty `Name? ` prompt, press Ctrl+D. Confirm
   stdin reaches EOF and the program exits with `input failed` and code `2`.
2. Run again. At `Name? `, press Ctrl+C. Confirm browser.cpp reports
   `Process interrupted.` and returns to its shell prompt.
3. Run once more and complete both inputs successfully. Confirm no input from
   either prior run appears in the new process.

## Buffered fallback test

Repeat in Firefox 140–152, or in a controlled environment where the worker does
not expose both `WebAssembly.Suspending` and `WebAssembly.promising`.

1. Choose **Compile and Run**.
2. Confirm the **Pre-supplied stdin** dialog opens.
3. Enter `Ada`, a newline, `41`, and a final newline; then choose **Run
   program**.
4. Confirm the same successful final output.

The fallback must not attempt message-interactive stdin merely from the Firefox
version string or main-window capabilities.

## Error exclusions

The terminal and Browser Console must not contain unexpected instances of:

```text
Interactive stdin requires SharedArrayBuffer
Cross-Origin-Opener-Policy
Cross-Origin-Embedder-Policy
JSPI is unavailable
Ignored stdin message for an inactive session
Unhandled promise rejection
```

## PR evidence

Record the following in the pull request or follow-up release evidence:

- Firefox version and tested artifact path
- exact observed prompt/output ordering
- confirmation that each input was entered only after its prompt appeared
- Ctrl+D, Ctrl+C, and clean-rerun results
- confirmation that the buffered dialog was absent on Firefox 153+ JSPI and
  present in the no-JSPI fallback test
- confirmation that stderr and the Browser Console had no unexpected errors
