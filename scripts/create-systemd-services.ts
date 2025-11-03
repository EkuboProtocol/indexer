import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type ServiceTarget = {
  scriptName: string;
  description: string;
};

type CliOptions = {
  outputDir: string;
  workingDir: string;
  runner: string;
  force: boolean;
};

const SERVICE_TARGETS: ServiceTarget[] = [
  {
    scriptName: 'eth:mainnet',
    description: 'Ekubo Indexer (Ethereum Mainnet)',
  },
  {
    scriptName: 'eth:sepolia',
    description: 'Ekubo Indexer (Ethereum Sepolia)',
  },
  {
    scriptName: 'starknet:mainnet',
    description: 'Ekubo Indexer (Starknet Mainnet)',
  },
  {
    scriptName: 'starknet:sepolia',
    description: 'Ekubo Indexer (Starknet Sepolia)',
  },
];

const DEFAULT_OPTIONS: CliOptions = {
  outputDir: path.resolve(process.cwd(), 'systemd'),
  workingDir: path.resolve(process.cwd()),
  runner: 'npm run',
  force: false,
};

function parseArgs(): CliOptions {
  const options: CliOptions = { ...DEFAULT_OPTIONS };
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inlineValue] = arg.includes('=')
      ? (arg.split('=', 2) as [string, string])
      : ([arg, undefined] as const);

    const nextValue = () => {
      const value = inlineValue ?? args[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (!inlineValue) {
        i += 1;
      }
      return value;
    };

    switch (flag) {
      case '--output-dir':
        options.outputDir = path.resolve(process.cwd(), nextValue());
        break;
      case '--working-dir':
        options.workingDir = path.resolve(process.cwd(), nextValue());
        break;
      case '--runner':
        options.runner = nextValue();
        break;
      case '--force':
        options.force = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

function serviceFileName(scriptName: string): string {
  return `ekubo-indexer-${scriptName.replace(/[:]/g, '-')}.service`;
}

function buildServiceFile({
  description,
  scriptName,
  workingDir,
  runner,
}: ServiceTarget & Pick<CliOptions, 'workingDir' | 'runner'>): string {
  const escapedRunner = runner.replace(/"/g, '\\"');
  const runCommand = `${escapedRunner} ${scriptName}`;

  return `[Unit]
Description=${description}
After=network.target
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=/usr/bin/env bash -lc "${runCommand}"
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  await fs.mkdir(options.outputDir, { recursive: true });

  for (const service of SERVICE_TARGETS) {
    const targetPath = path.join(
      options.outputDir,
      serviceFileName(service.scriptName),
    );

    if (!options.force && (await fileExists(targetPath))) {
      console.error(`Skipping existing file: ${targetPath}`);
      continue;
    }

    const content = buildServiceFile({
      ...service,
      workingDir: options.workingDir,
      runner: options.runner,
    });

    await fs.writeFile(targetPath, content, 'utf8');
    console.log(`Wrote ${targetPath}`);
  }

  console.log('Done. Enable services with: sudo systemctl enable <service>');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

