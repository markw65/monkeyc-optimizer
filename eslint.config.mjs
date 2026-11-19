import { createConfig } from "@markw65/project-utils";

const config = createConfig(
  {
    react: false,
    dirs: ["bin", "src", "test"],
  },
  { rules: { "import-x/no-cycle": "off" } }
);

export default config;
