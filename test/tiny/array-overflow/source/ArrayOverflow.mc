import Toybox.Lang;
import Toybox.Test;

const array_values = [
    0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225, 256, 289,
    324, 361, 400, 441, 484, 529, 576, 625, 676, 729, 784, 841, 900, 961, 1024,
    1089, 1156, 1225, 1296, 1369, 1444, 1521, 1600, 1681, 1764, 1849, 1936,
    2025, 2116, 2209, 2304, 2401, 2500, 2601, 2704, 2809, 2916, 3025, 3136,
    3249, 3364, 3481, 3600,
];

(:test)
function testPostBuildArrayInitStackOverflow(logger as Logger) as Boolean {
    for (var i = 0; i < array_values.size(); i++) {
        if (array_values[i] != i * i) {
            return false;
        }
    }
    return true;
}
