#!/usr/bin/env python3
"""
Example MCP Server for Code Analysis
This demonstrates how to create a custom MCP server for Visor
"""

import json
import sys
import os
from typing import Dict, List, Any

class CodeAnalyzer:
    """Custom code analyzer MCP server"""

    def __init__(self):
        self.analysis_level = os.environ.get('ANALYSIS_LEVEL', 'basic')

    def analyze_complexity(self, file_path: str) -> Dict[str, Any]:
        """Analyze code complexity"""
        # This is a simplified example
        # In reality, you would parse the code and calculate metrics
        return {
            "file": file_path,
            "complexity": {
                "cyclomatic": 5,
                "cognitive": 8,
                "lines_of_code": 150,
                "functions": 10
            },
            "level": self.analysis_level
        }

    def find_patterns(self, file_path: str) -> List[Dict[str, Any]]:
        """Find code patterns and anti-patterns"""
        return [
            {
                "pattern": "singleton",
                "location": f"{file_path}:45",
                "type": "design_pattern"
            },
            {
                "pattern": "god_object",
                "location": f"{file_path}:120",
                "type": "anti_pattern",
                "severity": "warning"
            }
        ]

    def suggest_refactoring(self, file_path: str) -> List[str]:
        """Suggest refactoring opportunities"""
        return [
            "Consider extracting method at line 45-60",
            "Duplicate code detected at lines 120 and 180",
            "Complex conditional at line 95 could be simplified"
        ]

def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Handle MCP protocol requests"""
    analyzer = CodeAnalyzer()

    method = request.get('method')
    params = request.get('params', {})

    if method == 'analyze_complexity':
        result = analyzer.analyze_complexity(params.get('file'))
    elif method == 'find_patterns':
        result = analyzer.find_patterns(params.get('file'))
    elif method == 'suggest_refactoring':
        result = analyzer.suggest_refactoring(params.get('file'))
    else:
        result = {"error": f"Unknown method: {method}"}

    return {
        "jsonrpc": "2.0",
        "id": request.get('id'),
        "result": result
    }

def main():
    """Main entry point for MCP server"""
    # Read from stdin (MCP protocol)
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break

            request = json.loads(line)
            response = handle_request(request)

            # Write response to stdout
            sys.stdout.write(json.dumps(response) + '\n')
            sys.stdout.flush()

        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            sys.stdout.write(json.dumps(error_response) + '\n')
            sys.stdout.flush()
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            sys.stdout.write(json.dumps(error_response) + '\n')
            sys.stdout.flush()

if __name__ == "__main__":
    main()