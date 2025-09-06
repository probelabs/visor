// Test file to demonstrate debug functionality
function processUserInput(userInput) {
  // This will trigger security warnings for testing
  return eval(userInput);  // Dangerous use of eval - should be flagged
}

// This function has potential performance issues
function inefficientSearch(array, target) {
  for (let i = 0; i < array.length; i++) {
    for (let j = 0; j < array.length; j++) {
      if (array[i] === target) {
        return i;
      }
    }
  }
  return -1;
}

module.exports = { processUserInput, inefficientSearch };