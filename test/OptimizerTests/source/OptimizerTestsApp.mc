import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

//typedef InitialViewReturn as Array<Views or InputDelegates>;
typedef InitialViewReturn as [Views] or [Views, InputDelegates];

class OptimizerTestsApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    // onStart() is called on application start up
    function onStart(state as Lang.Dictionary?) as Void {}

    // onStop() is called when your application is exiting
    function onStop(state as Lang.Dictionary?) as Void {}

    // Return the initial view of your application here
    function getInitialView() {
        return (
            [new OptimizerTestsView(), new OptimizerTestsDelegate()] as
            InitialViewReturn
        );
    }
}

function getApp() as OptimizerTestsApp {
    return Application.getApp() as OptimizerTestsApp;
}
