const { driver, error } = require("../build/driver.cjs");

driver()
  .then(() => console.log("Success"))
  .catch((e) => {
    error("Failed:\n" + (e.stack ? e.stack.toString() : e.toString()));
  });
