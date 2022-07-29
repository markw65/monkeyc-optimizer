import { driver, error } from "../build/driver.cjs";

driver()
  .then(() => console.log("Success"))
  .catch((e) => {
    error("Failed: " + e.toString());
  });
