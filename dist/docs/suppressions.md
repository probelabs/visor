## 🔇 Suppressing Warnings

Visor supports suppressing specific warnings or all warnings in a file using special comments in your code. This is useful for false positives or intentional code patterns that should not trigger warnings.

### Line-Level Suppression

Add `visor-disable` in a comment within ±2 lines of the issue to suppress it:

```javascript
// Example: Suppress a specific warning
function authenticate() {
  const testPassword = "demo123"; // visor-disable
  // This hardcoded password warning will be suppressed
}
```

The suppression works with any comment style:
- `// visor-disable` (JavaScript, TypeScript, C++, etc.)
- `# visor-disable` (Python, Ruby, Shell, etc.)
- `/* visor-disable */` (Multi-line comments)
- `<!-- visor-disable -->` (HTML, XML)

### File-Level Suppression

To suppress all warnings in an entire file, add `visor-disable-file` in the first 5 lines:

```javascript
// visor-disable-file
// All warnings in this file will be suppressed

function insecureCode() {
  eval("user input"); // No warning
  const password = "hardcoded"; // No warning
}
```

### Configuration

The suppression feature is enabled by default. You can disable it in your configuration:

```yaml
# .visor.yaml
version: "1.0"
output:
  suppressionEnabled: false  # Disable suppression comments
  pr_comment:
    format: markdown
    group_by: check
```

### Important Notes

- Suppression comments are case-insensitive (`visor-disable`, `VISOR-DISABLE`, `Visor-Disable`)
- The comment just needs to contain the suppression keyword as a substring
- When issues are suppressed, Visor logs a summary showing which files had suppressed issues
- Use suppression judiciously - it's better to fix issues than suppress them

### Examples

```python
# Python example
def process_data():
    api_key = "sk-12345"  # visor-disable
    return api_key
```

```typescript
// TypeScript example - suppress within range
function riskyOperation() {
  // visor-disable
  const unsafe = eval(userInput); // Suppressed (within 2 lines)
  processData(unsafe);             // Suppressed (within 2 lines)

  doSomethingElse();
  anotherOperation();              // NOT suppressed (> 2 lines away)
}
```

```go
// Go example - file-level suppression
// visor-disable-file
package main

func main() {
    password := "hardcoded" // All issues suppressed
    fmt.Println(password)
}
```

