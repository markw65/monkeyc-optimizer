import Toybox.Lang;
import Toybox.Test;
import Toybox.WatchUi;

(:test)
function testRezStarTypes(logger as Logger) as Boolean {
    var x = WatchUi.loadResource(Rez.Strings.AppName);
    return x.equals("OptimizerTests");
}
