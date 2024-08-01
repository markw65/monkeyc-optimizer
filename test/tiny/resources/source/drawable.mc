import Toybox.Lang;
import Toybox.WatchUi;
import Toybox.Test;

class CustomDrawable extends WatchUi.Drawable {
    function initialize(
        options as
            {
                :identifier as Object,
                :locX as Numeric,
                :locY as Numeric,
                :width as Numeric,
                :height as Numeric,
                :visible as Boolean,
            }
    ) {
        Drawable.initialize(options);
    }
}
