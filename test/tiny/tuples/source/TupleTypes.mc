import Toybox.Application;
import Toybox.Lang;
import Toybox.Test;
import Toybox.WatchUi;

//typedef InitialViewReturn as Array<Views or InputDelegates>;
typedef InitialViewReturn as [Views] or [Views, InputDelegates];

class TupleTypesApp extends Application.AppBase {
  function initialize() {
    AppBase.initialize();
  }

  function getInitialView() {
    return [new TupleTypesSimpleDataField()] as InitialViewReturn;
  }
}

class TupleTypesSimpleDataField extends WatchUi.SimpleDataField {
}

class Test1 {
    function initialize(value as [Number]) {}
}
