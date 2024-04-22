import Toybox.Lang;
import Toybox.WatchUi;

class TestDrawable extends WatchUi.Drawable {
  enum TestEnum {
    VALUE,
  }

  public var value as TestEnum;

  function initialize(
    settings as
      {
        :identifier as Object,
        :locX as Numeric,
        :locY as Numeric,
        :width as Numeric,
        :height as Numeric,
        :visible as Boolean,
        :enumValue as TestEnum,
      }
  ) {
    Drawable.initialize(settings);

    value = settings.get(:enumValue) as TestEnum;
  }
}
