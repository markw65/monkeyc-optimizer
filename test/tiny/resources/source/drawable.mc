import Toybox.Lang;
import Toybox.WatchUi;
import Toybox.Test;

class CustomDrawable extends WatchUi.Drawable {
    private var myBitmap as ResourceId = Rez.Drawables.system_icon_dark__check;
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
