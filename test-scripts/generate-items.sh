#!/bin/bash

# Test script for forEach functionality
# Generates JSON with an array of items

cat <<EOF
{
  "metadata": {
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "source": "test-script"
  },
  "items": [
    {
      "id": 1,
      "name": "First Item",
      "status": "active",
      "priority": "high"
    },
    {
      "id": 2,
      "name": "Second Item",
      "status": "pending",
      "priority": "medium"
    },
    {
      "id": 3,
      "name": "Third Item",
      "status": "completed",
      "priority": "low"
    },
    {
      "id": 4,
      "name": "Fourth Item",
      "status": "active",
      "priority": "critical"
    }
  ],
  "summary": {
    "total": 4,
    "active": 2,
    "pending": 1,
    "completed": 1
  }
}
EOF