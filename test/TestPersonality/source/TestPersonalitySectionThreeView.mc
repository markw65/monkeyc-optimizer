//
// Copyright 2015-2021 by Garmin Ltd. or its subsidiaries.
// Subject to Garmin SDK License Agreement and Wearables
// Application Developer Agreement.
//

import Toybox.Graphics;
import Toybox.Lang;
import Toybox.UserProfile;
import Toybox.WatchUi;

//! Shows user information about activity level and birth year
class TestPersonalitySectionThreeView extends WatchUi.View {
    private var _activityPrefixStr as String;
    private var _lowActivityStr as String;
    private var _medActivityStr as String;
    private var _highActivityStr as String;
    private var _birthYearPrefixStr as String;
    private var _itemNotSetStr as String;

    //! Constructor
    public function initialize() {
        View.initialize();

        _activityPrefixStr =
            WatchUi.loadResource($.Rez.Strings.ActivityLevelPrefix) as String;
        _lowActivityStr =
            WatchUi.loadResource($.Rez.Strings.LowActivityLevel) as String;
        _medActivityStr =
            WatchUi.loadResource($.Rez.Strings.MediumActivityLevel) as String;
        _highActivityStr =
            WatchUi.loadResource($.Rez.Strings.HighActivityLevel) as String;
        _birthYearPrefixStr =
            WatchUi.loadResource($.Rez.Strings.BirthYearPrefix) as String;
        _itemNotSetStr =
            WatchUi.loadResource($.Rez.Strings.ItemNotSet) as String;
    }

    //! Load your resources here
    //! @param dc Device context
    public function onLayout(dc as Dc) as Void {
        setLayout($.Rez.Layouts.SectionThreeLayout(dc));
    }

    //! Update the view
    //! @param dc Device Context
    public function onUpdate(dc as Dc) as Void {
        var profile = UserProfile.getProfile();

        var string = _activityPrefixStr;
        var activityClass = profile.activityClass;
        if (activityClass != null) {
            if (activityClass <= 20) {
                string +=
                    _lowActivityStr + " (" + activityClass.toString() + ")";
            } else if (activityClass <= 50) {
                string +=
                    _medActivityStr + " (" + activityClass.toString() + ")";
            } else {
                string +=
                    _highActivityStr + " (" + activityClass.toString() + ")";
            }
        } else {
            string += _itemNotSetStr;
        }
        (findDrawableById("ActivityLevelLabel") as Text).setText(string);

        var birthYear = profile.birthYear;
        string = _birthYearPrefixStr;
        if (birthYear != null) {
            string += birthYear.toString();
        } else {
            string += _itemNotSetStr;
        }
        (findDrawableById("BirthYearLabel") as Text).setText(string);

        View.onUpdate(dc);
    }
}
