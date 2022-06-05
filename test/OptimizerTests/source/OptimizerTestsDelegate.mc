import Toybox.Lang;
import Toybox.WatchUi;

class OptimizerTestsDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onMenu() as Boolean {
        WatchUi.pushView(
            new Rez.Menus.MainMenu(),
            new OptimizerTestsMenuDelegate(),
            WatchUi.SLIDE_UP
        );
        return true;
    }
}
