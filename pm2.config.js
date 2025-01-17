module.exports = {
  apps: [
    {
      name: "sepolia",
      script: "src/index.ts",
      cwd: ".",
      interpreter: "bun",
      env: {
        NETWORK: "sepolia",
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`, // Add "~/.bun/bin/bun" to PATH
      },
    },
    {
      name: "mainnet",
      script: "src/index.ts",
      cwd: ".",
      interpreter: "bun",
      env: {
        NETWORK: "mainnet",
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`, // Add "~/.bun/bin/bun" to PATH
      },
    },
  ],
};
