import Toybox.Application;
import Toybox.Lang;
import Toybox.Test;
import Toybox.WatchUi;

//typedef InitialViewReturn as Array<Views or InputDelegates>;
typedef InitialViewReturn as [Views] or [Views, InputDelegates];

class TinyApp extends Application.AppBase {
  function initialize() {
    AppBase.initialize();
  }

  function getInitialView() {
    return [new TinySimpleDataField()] as InitialViewReturn;
  }
}

class TinySimpleDataField extends WatchUi.SimpleDataField {
}
