## 🌐 HTTP Integration & Scheduling

Visor provides comprehensive HTTP integration capabilities including webhook reception, HTTP outputs, scheduled executions via cron, and TLS/HTTPS support.

### HTTP Server for Webhook Reception

Configure an HTTP/HTTPS server to receive webhooks and trigger checks:

```yaml
version: "1.0"

http_server:
  enabled: true
  port: 8080
  host: "0.0.0.0"

  # Optional TLS/HTTPS configuration
  tls:
    enabled: true
    cert: "${TLS_CERT}"  # From environment variable
    key: "${TLS_KEY}"
    ca: "${TLS_CA}"      # Optional CA certificate
    rejectUnauthorized: true

  # Authentication
  auth:
    type: bearer_token
    secret: "${WEBHOOK_SECRET}"

  # Webhook endpoints
  endpoints:
    - path: "/webhook/github"
      name: "github-events"
    - path: "/webhook/jenkins"
      name: "jenkins-builds"
```

Note: The HTTP server is automatically disabled when running in GitHub Actions to avoid conflicts.

### Check Types for HTTP Integration

#### 1. HTTP Input (Webhook Receiver)
Receive data from configured webhook endpoints:

```yaml
checks:
  github-webhook:
    type: http_input
    endpoint: "/webhook/github"
    on: [webhook_received]
    transform: |
      {
        "event": "{{ webhook.action }}",
        "repository": "{{ webhook.repository.full_name }}"
      }
```

#### 2. HTTP Output (Send Data)
Send check results to external services:

```yaml
checks:
  notify-external:
    type: http
    depends_on: [security-check]
    url: "https://api.example.com/notify"
    method: POST
    headers:
      Content-Type: "application/json"
      Authorization: "Bearer ${API_TOKEN}"
    body: |
      {
        "results": {{ outputs['security-check'] | json }},
        "timestamp": "{{ 'now' | date: '%Y-%m-%d %H:%M:%S' }}"
      }
```

#### 3. HTTP Client (Fetch Data)
Fetch data from external APIs:

```yaml
checks:
  fetch-config:
    type: http_client
    url: "https://api.example.com/config"
    method: GET
    headers:
      Authorization: "Bearer ${API_TOKEN}"
    transform: |
      {
        "settings": {{ response.data | json }},
        "fetched_at": "{{ 'now' | date: '%Y-%m-%d' }}"
      }
```

#### 4. Log Provider (Debugging & Monitoring)
Output debugging information and monitor workflow execution:

```yaml
checks:
  debug-start:
    type: log
    group: debugging
    level: info
    message: "🚀 Starting code review for PR #{{ pr.number }} by {{ pr.author }}"
    include_pr_context: true
    include_dependencies: false
    include_metadata: true

  debug-dependencies:
    type: log
    group: debugging
    level: debug
    depends_on: [security-check]
    message: |
      📊 Dependency results summary:
      {% if dependencies %}
      - Security check found {{ dependencies['security-check'].issueCount }} issues
      {% else %}
      - No dependencies processed
      {% endif %}
    include_dependencies: true

  performance-monitor:
    type: log
    group: monitoring
    level: warn
    message: "⚠️ Large PR detected: {{ pr.totalAdditions }} lines added"
```

### Cron Scheduling

```yaml
checks:
  nightly-security-scan:
    type: ai
    schedule: "0 3 * * *"  # Every day at 3am
    prompt: "Run a deep security scan on the default branch"
```

```yaml
checks:
  weekly-health-check:
    type: http_client
    url: "https://api.example.com/health"
    schedule: "0 0 * * 0"  # Every Sunday at midnight
```

### TLS/HTTPS Configuration

You can configure TLS using environment variables, direct file paths, or Let's Encrypt.

#### Environment Variables
```yaml
tls:
  enabled: true
  cert: "${TLS_CERT}"
  key: "${TLS_KEY}"
```

#### File Paths
```yaml
tls:
  enabled: true
  cert: "/etc/ssl/certs/server.crt"
  key: "/etc/ssl/private/server.key"
```

#### Let's Encrypt
```yaml
tls:
  enabled: true
  cert: "/etc/letsencrypt/live/example.com/fullchain.pem"
  key: "/etc/letsencrypt/live/example.com/privkey.pem"
```

### HTTP Security Features

Visor's HTTP server includes comprehensive security protections:

#### Authentication Methods
```yaml
# Bearer Token Authentication
auth:
  type: bearer_token
  secret: "${WEBHOOK_SECRET}"

# HMAC-SHA256 Signature Verification
auth:
  type: hmac
  secret: "${WEBHOOK_SECRET}"

# Basic Authentication
auth:
  type: basic
  username: "${HTTP_USERNAME}"
  password: "${HTTP_PASSWORD}"
```

#### HMAC Authentication Details
For `hmac` authentication, webhooks must include the `x-webhook-signature` header:
- Signature format: `sha256={hash}`
- Uses HMAC-SHA256 with the configured secret
- Implements timing-safe comparison to prevent timing attacks
- Compatible with GitHub webhook signatures

#### DoS Protection
- Request size limits: Maximum 1MB request body size
- Early rejection: Validates `Content-Length` header before processing
- Graceful error handling: Returns proper HTTP status codes (413 Payload Too Large)

#### Security Best Practices
- Environment detection: Automatically disables in GitHub Actions
- TLS support: Full HTTPS configuration with custom certificates
- Input validation: Validates all webhook payloads before processing
- Error isolation: Security failures don't affect independent checks

### Complete HTTP Pipeline Example

```yaml
version: "1.0"

# HTTP server configuration
http_server:
  enabled: true
  port: 8443
  tls:
    enabled: true
    cert: "${TLS_CERT}"
    key: "${TLS_KEY}"
  auth:
    type: bearer_token
    secret: "${WEBHOOK_SECRET}"
  endpoints:
    - path: "/webhook/deployment"
      name: "deployment-trigger"

checks:
  # 1. Receive webhook
  deployment-webhook:
    type: http_input
    endpoint: "/webhook/deployment"
    on: [webhook_received]
    transform: |
      {
        "version": "{{ webhook.version }}",
        "environment": "{{ webhook.environment }}"
      }

  # 2. Analyze deployment
  deployment-analysis:
    type: ai
    depends_on: [deployment-webhook]
    prompt: |
      Analyze deployment for version {{ outputs['deployment-webhook'].suggestions | first }}
      Check for potential issues and risks

  # 3. Fetch current status
  current-status:
    type: http_client
    depends_on: [deployment-webhook]
    url: "https://api.example.com/status"
    method: GET

  # 4. Send results
  notify-team:
    type: http
    depends_on: [deployment-analysis, current-status]
    url: "https://slack.example.com/webhook"
    body: |
      {
        "text": "Deployment Analysis Complete",
        "analysis": {{ outputs['deployment-analysis'] | json }},
        "current_status": {{ outputs['current-status'] | json }}
      }

  # 5. Scheduled health check
  health-check:
    type: http_client
    url: "https://api.example.com/health"
    schedule: "*/5 * * * *"  # Every 5 minutes
    transform: |
      {
        "status": "{{ response.status }}",
        "checked_at": "{{ 'now' | date: '%Y-%m-%d %H:%M:%S' }}"
      }
```

### Liquid Template Support

All HTTP configurations support Liquid templating for dynamic content. See [Liquid Templates Guide](./liquid-templates.md) for complete reference.

Common patterns:
- Access webhook data: `{{ webhook.field }}`
- Access headers: `{{ headers['x-custom-header'] }}`
- Access previous outputs: `{{ outputs['check-name'].suggestions | first }}`
- Date formatting: `{{ 'now' | date: '%Y-%m-%d' }}`
- JSON encoding: `{{ data | json }}` (useful for debugging objects)

