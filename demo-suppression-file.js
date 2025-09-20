#!/usr/bin/env node
// visor-disable-file

/**
 * Demo script showing file-level suppression
 * ALL warnings in this file will be suppressed
 */

function completelyUnsafeCode() {
  // None of these will trigger warnings due to file-level suppression
  const password = "admin123";
  const apiKey = "sk-production-key";
  const secret = "super-secret-value";

  eval("arbitrary code execution");

  const sqlQuery = `SELECT * FROM users WHERE id = ${userInput}`;

  return { password, apiKey, secret, sqlQuery };
}

function anotherUnsafeFunction() {
  // Still suppressed - file-level suppression affects everything
  const token = "bearer-12345";
  const privateKey = "-----BEGIN RSA PRIVATE KEY-----";

  return { token, privateKey };
}

console.log("This file has file-level suppression enabled");
console.log("NO warnings will be reported for this file");