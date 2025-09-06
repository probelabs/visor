// Test file to trigger CLI mode with actual code analysis
function testSecurity() {
  // This should trigger security warnings
  return eval('console.log("test")');  // Security issue: eval usage
}

function testPerformance() {
  // This should trigger performance warnings  
  const arr = [1,2,3,4,5];
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length; j++) {  // Performance issue: nested loops
      console.log(arr[i], arr[j]);
    }
  }
}

function testStyle() {
  var badVariable = "should use const/let";  // Style issue: var usage
  console.log(badVariable);  // Style issue: console.log
}

// Architecture issue: large function doing too many things
function testArchitecture() {
  testSecurity();
  testPerformance(); 
  testStyle();
  console.log("All done");
}

module.exports = { testSecurity, testPerformance, testStyle, testArchitecture };