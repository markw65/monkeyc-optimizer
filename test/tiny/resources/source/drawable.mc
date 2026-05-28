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

class CustomButton extends WatchUi.Button {
    function initialize(options as { :behavior as Symbol }) {
        Button.initialize(options);
    }
}

/* @match > "function myBehavior" */
class CustomButtonDelegate extends WatchUi.BehaviorDelegate {
    public function initialize(view as WatchUi.View) {
        BehaviorDelegate.initialize();
    }

    public function myBehavior(keyEvent as KeyEvent) as Boolean {
        return true;
    }
}
