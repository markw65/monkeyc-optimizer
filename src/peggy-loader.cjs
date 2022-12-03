const peggy = require("peggy");

module.exports = function peggy_loader(source) {
  return peggy.generate(source, {
    cache: false,
    format: "es",
    output: "source",
  });
};
