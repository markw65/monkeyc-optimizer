import Toybox.Lang;
import Toybox.Test;

(:test)
function testEnums(logger as Logger) as Boolean {
  var wrapper = new Wrapper();
  return wrapper.test(logger);
}

class Wrapper {
  enum MixedTypeEnum {
    FALSE = false,
    TRUE = true,
    FORTY_TWO = 42,
    NULL = null,
  }

  function test(logger as Logger) as Boolean {
    return (
      boolFunc(FALSE, logger) == false &&
      boolFunc(TRUE, logger) == true &&
      numFunc(FORTY_TWO, logger) == 42 &&
      (enumFunc(FALSE, logger) as Boolean) == false &&
      (enumFunc(FORTY_TWO, logger) as Number) == 42 &&
      nullFunc(NULL, logger) == null
    );
  }

  function boolFunc(v as Boolean, logger as Logger) as Boolean {
    logger.debug(v);
    return v;
  }

  function numFunc(v as Number, logger as Logger) as Number {
    logger.debug(v);
    return v;
  }
  function nullFunc(v as Null, logger as Logger) as Null {
    logger.debug(v == null);
    return v;
  }

  function enumFunc(v as MixedTypeEnum, logger as Logger) as MixedTypeEnum {
    logger.debug(v as Object);
    return v;
  }
}
