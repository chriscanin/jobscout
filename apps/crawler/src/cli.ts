import "dotenv/config";
import { Command } from "commander";

const program = new Command();

program
  .name("jobscout")
  .description("jobscout crawler CLI")
  .version("0.0.0");

program
  .command("crawl")
  .description("Run a single crawl across all active adapters")
  .action(() => {
    throw new Error("not implemented: crawl");
  });

program
  .command("loop")
  .description("Run crawl on a recurring interval")
  .option("--interval <minutes>", "Interval in minutes between crawls", "60")
  .action(() => {
    throw new Error("not implemented: loop");
  });

program
  .command("discover")
  .description("Run web-search-based company discovery")
  .action(() => {
    throw new Error("not implemented: discover");
  });

program
  .command("doctor")
  .description("Check environment and connectivity, report status")
  .action(() => {
    throw new Error("not implemented: doctor");
  });

program.parse(process.argv);
