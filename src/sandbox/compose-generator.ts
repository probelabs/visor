/**
 * Generates docker-compose.yml files from project service configurations.
 * Used to spin up project-level services (redis, postgres, etc.) alongside
 * workspace containers for code exploration and testing.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { ProjectServiceConfig, SandboxConfig } from './types';
import { logger } from '../logger';
import { withActiveSpan, addEvent } from './sandbox-telemetry';

/** Well-known default ports for common service images */
const DEFAULT_PORTS: Record<string, number> = {
  redis: 6379,
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongo: 27017,
  mongodb: 27017,
  rabbitmq: 5672,
  elasticsearch: 9200,
  memcached: 11211,
  minio: 9000,
  nats: 4222,
};

/**
 * Infer the default port for a service based on its name or image.
 */
function inferPort(serviceName: string, image: string): number | undefined {
  const name = serviceName.toLowerCase();
  if (DEFAULT_PORTS[name]) return DEFAULT_PORTS[name];
  const imageBase = image.split(':')[0].split('/').pop()?.toLowerCase() ?? '';
  return DEFAULT_PORTS[imageBase];
}

export interface GenerateComposeOptions {
  /** Project identifier */
  projectId: string;
  /** Session identifier (for unique compose project naming) */
  sessionId: string;
  /** Project services to include */
  services: Record<string, ProjectServiceConfig>;
  /** The sandbox config for the workspace container (optional) */
  workspaceSandbox?: SandboxConfig;
  /** Host path to mount as /workspace */
  workspacePath: string;
  /** Visor dist path to mount as /opt/visor */
  visorDistPath: string;
  /** Directory to write the compose file to */
  outputDir: string;
}

export interface GenerateComposeResult {
  /** Absolute path to the generated docker-compose.yml */
  filePath: string;
  /** Docker Compose project name */
  projectName: string;
  /** Workspace service name to exec into */
  serviceName: string;
  /** Service endpoints for env injection */
  serviceEndpoints: Record<string, { host: string; port: number }>;
}

/**
 * Generate a docker-compose.yml from project service configurations.
 *
 * Key design decisions:
 * - No host ports: services communicate via compose DNS (service name as hostname)
 * - Workspace container uses `sleep infinity` to stay alive for exec
 * - Port inference from well-known service names/images
 */
export async function generateComposeFile(
  options: GenerateComposeOptions
): Promise<GenerateComposeResult> {
  return withActiveSpan(
    'visor.compose.generate',
    {
      'visor.project.id': options.projectId,
      'visor.compose.service_count': Object.keys(options.services).length,
      'visor.compose.services': Object.keys(options.services).join(','),
    },
    async () => {
      const sessionPrefix = options.sessionId.slice(0, 8);
      const projectName = `visor-${options.projectId}-${sessionPrefix}`;
      const serviceName = 'workspace';

      const composeServices: Record<string, any> = {};
      const serviceEndpoints: Record<string, { host: string; port: number }> = {};
      const dependsOn: string[] = [];

      // Build service definitions
      for (const [name, svcConfig] of Object.entries(options.services)) {
        const svcDef: any = { image: svcConfig.image };

        if (svcConfig.environment && Object.keys(svcConfig.environment).length > 0) {
          svcDef.environment = svcConfig.environment;
        }
        if (svcConfig.volumes && svcConfig.volumes.length > 0) {
          svcDef.volumes = svcConfig.volumes;
        }
        if (svcConfig.healthcheck) {
          svcDef.healthcheck = {
            test: svcConfig.healthcheck.test,
            ...(svcConfig.healthcheck.interval && { interval: svcConfig.healthcheck.interval }),
            ...(svcConfig.healthcheck.timeout && { timeout: svcConfig.healthcheck.timeout }),
            ...(svcConfig.healthcheck.retries && { retries: svcConfig.healthcheck.retries }),
          };
        }

        composeServices[name] = svcDef;
        dependsOn.push(name);

        // Determine port for endpoint registration
        const port = svcConfig.ports?.[0] ?? inferPort(name, svcConfig.image);
        if (port) {
          serviceEndpoints[name] = { host: name, port };
        }
      }

      // Build workspace service
      const workspaceImage = options.workspaceSandbox?.image ?? 'ubuntu:22.04';
      const workspaceWorkdir = options.workspaceSandbox?.workdir ?? '/workspace';

      const workspaceDef: any = {
        image: workspaceImage,
        working_dir: workspaceWorkdir,
        volumes: [
          `${options.workspacePath}:${workspaceWorkdir}`,
          `${options.visorDistPath}:/opt/visor:ro`,
        ],
        command: 'sleep infinity',
      };

      if (dependsOn.length > 0) {
        workspaceDef.depends_on = dependsOn;
      }

      composeServices[serviceName] = workspaceDef;

      // Compose file structure
      const composeDoc = {
        name: projectName,
        services: composeServices,
      };

      // Write to output directory
      if (!existsSync(options.outputDir)) {
        mkdirSync(options.outputDir, { recursive: true });
      }

      const filePath = join(options.outputDir, `docker-compose-${options.projectId}.yml`);
      const yamlContent = yaml.dump(composeDoc, { lineWidth: 120, noRefs: true });
      writeFileSync(filePath, yamlContent, 'utf8');

      addEvent('visor.compose.generated', {
        'visor.project.id': options.projectId,
        'visor.compose.file': filePath,
        'visor.compose.project_name': projectName,
        'visor.compose.endpoints': JSON.stringify(serviceEndpoints),
      });

      logger.info(`Generated compose file for project '${options.projectId}' at ${filePath}`);

      return { filePath, projectName, serviceName, serviceEndpoints };
    }
  );
}
