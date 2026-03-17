import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Check if Docker daemon is available.
 */
export function checkDocker(): boolean {
  try {
    execSync("docker info", { timeout: 10000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker Compose (v2 plugin) is available.
 */
export function checkDockerCompose(): boolean {
  try {
    execSync("docker compose version", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check port availability. Returns a Map of port -> process name holding it, or null if free.
 */
export function checkPorts(ports: number[]): Map<number, string | null> {
  const result = new Map<number, string | null>();

  for (const port of ports) {
    const processName = getPortProcess(port);
    result.set(port, processName);
  }

  return result;
}

function getPortProcess(port: number): string | null {
  // Try lsof first (works on Linux and macOS)
  try {
    const output = execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, {
      timeout: 5000,
      stdio: "pipe",
    }).toString().trim();

    if (output) {
      // Got a PID, try to get process name
      const pid = output.split("\n")[0]!;
      try {
        const nameOutput = execSync(`lsof -i :${port} -sTCP:LISTEN -P -n 2>/dev/null | tail -1 | awk '{print $1}'`, {
          timeout: 5000,
          stdio: "pipe",
        }).toString().trim();
        return nameOutput || `PID ${pid}`;
      } catch {
        return `PID ${pid}`;
      }
    }
  } catch {
    // lsof not available or no result
  }

  // Fallback: try ss (Linux)
  try {
    const output = execSync(`ss -tlnp sport = :${port} 2>/dev/null`, {
      timeout: 5000,
      stdio: "pipe",
    }).toString().trim();

    // ss always outputs a header line. If there are data lines after the header,
    // the port is in use.
    const lines = output.split("\n").filter(Boolean);
    if (lines.length > 1) {
      // Extract process info from the last line
      const dataLine = lines[1]!;
      const processMatch = dataLine.match(/users:\(\("([^"]+)"/);
      return processMatch ? processMatch[1]! : "unknown";
    }
  } catch {
    // ss not available
  }

  // Port is free
  return null;
}

export interface ComposeConfig {
  neo4jPassword: string;
  neo4jBoltPort: number;
  neo4jHttpPort: number;
  qdrantPort: number;
  dataDir: string;
}

/**
 * Generate docker-compose.yml content from config.
 * Password is inlined (not via env var).
 */
export function generateCompose(cfg: ComposeConfig): string {
  return `services:
  neo4j:
    image: neo4j:5-community
    container_name: semantic-memory-neo4j
    ports:
      - "${cfg.neo4jHttpPort}:7474"
      - "${cfg.neo4jBoltPort}:7687"
    environment:
      NEO4J_AUTH: neo4j/${cfg.neo4jPassword}
      NEO4J_PLUGINS: '[]'
      NEO4J_server_memory_heap_initial__size: 512m
      NEO4J_server_memory_heap_max__size: 1G
    volumes:
      - ./data/neo4j:/data
    healthcheck:
      test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "${cfg.neo4jPassword}", "RETURN 1"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:latest
    container_name: semantic-memory-qdrant
    ports:
      - "${cfg.qdrantPort}:6333"
    volumes:
      - ./data/qdrant:/qdrant/storage
    healthcheck:
      test: ["CMD", "bash", "-c", "echo > /dev/tcp/localhost/6333"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
`;
}

/**
 * Run docker compose up -d for the given compose file.
 */
export function composeUp(composeFile: string): void {
  execSync(`docker compose -f "${composeFile}" up -d`, {
    timeout: 120000,
    stdio: "pipe",
  });
}

/**
 * Run docker compose down for the given compose file.
 */
export function composeDown(composeFile: string): void {
  execSync(`docker compose -f "${composeFile}" down`, {
    timeout: 60000,
    stdio: "pipe",
  });
}

/**
 * Wait for all services in compose file to become healthy.
 * @param composeFile - path to docker-compose.yml
 * @param timeout - max wait in milliseconds
 */
export function waitForHealthy(composeFile: string, timeout: number): boolean {
  if (!existsSync(composeFile)) return false;

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const output = execSync(
        `docker compose -f "${composeFile}" ps --format json`,
        { timeout: 10000, stdio: "pipe" },
      ).toString().trim();

      if (!output) {
        execSync("sleep 2");
        continue;
      }

      const lines = output.split("\n").filter(Boolean);
      if (lines.length === 0) {
        execSync("sleep 2");
        continue;
      }

      let allHealthy = true;
      for (const line of lines) {
        try {
          const container = JSON.parse(line) as { State?: string; Health?: string };
          if (container.State !== "running" || (container.Health && container.Health !== "healthy")) {
            allHealthy = false;
            break;
          }
        } catch {
          allHealthy = false;
          break;
        }
      }

      if (allHealthy) return true;
    } catch {
      // not ready yet
    }

    execSync("sleep 2");
  }

  return false;
}

/**
 * Detect if running inside WSL (Windows Subsystem for Linux).
 */
export function detectWSL(): boolean {
  // Check WSL_DISTRO_NAME environment variable
  if (process.env["WSL_DISTRO_NAME"]) return true;

  // Check for WSLInterop in binfmt_misc
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch {
    return false;
  }
}
