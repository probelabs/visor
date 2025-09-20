#!/usr/bin/env node

/**
 * Demo script to show Visor suppression feature
 * Run Visor on this file to see how suppression works
 */

// Example 1: Line-level suppression
function authenticateUser() {
  const hardcodedPassword = "admin123"; // visor-disable
  // The above hardcoded password won't trigger a warning

  // This one will trigger a warning (no suppression)
  const anotherPassword = "secret456";

  return { hardcodedPassword, anotherPassword };
}

// Example 2: Suppression works within ±2 lines
function processData() {
  // visor-disable
  const apiKey = "sk-1234567890"; // Suppressed (1 line away)
  const secret = "my-secret";     // Suppressed (2 lines away)

  const notSuppressed = "another-secret"; // NOT suppressed (3 lines away)

  return { apiKey, secret, notSuppressed };
}

// Example 3: Case-insensitive suppression
function mixedCase() {
  const test1 = "secret1"; // VISOR-DISABLE
  const test2 = "secret2"; // Visor-Disable
  const test3 = "secret3"; // visor-disable

  // All three above will be suppressed
  return { test1, test2, test3 };
}

// Example 4: Without suppression (all these will trigger warnings)
function insecureCode() {
  eval("user input");
  const password = "plaintext";
  const token = "bearer-token-12345";

  return { password, token };
}

console.log("Demo script for Visor suppression feature");
console.log("Run 'visor --check security' on this file to see suppression in action");