// Test file for triggering GitHub Action review with proper Google model
function calculateSum(a: number, b: number): number {
    return a + b;
}

// Add a potential security issue for AI to detect
function unsafeQuery(userInput: string) {
    // This should trigger security check - SQL injection risk
    const query = `SELECT * FROM users WHERE name = '${userInput}'`;
    return query;
}

// Add performance issue for AI to detect  
function inefficientLoop() {
    // This should trigger performance check - inefficient nested loops
    const result = [];
    for (let i = 0; i < 1000; i++) {
        for (let j = 0; j < 1000; j++) {
            result.push(i * j);
        }
    }
    return result;
}

// Add style issue for AI to detect
function badStyle() {
    // This should trigger style check - inconsistent naming and formatting
    var x=1;let   Y = 2;const  Z=3;
    return x+Y+Z;
}

console.log("Fixed GOOGLE_API_KEY model mismatch - now using Google model with Google API key");