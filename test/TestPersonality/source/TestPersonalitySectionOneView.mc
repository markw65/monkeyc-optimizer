//
// Copyright 2015-2021 by Garmin Ltd. or its subsidiaries.
// Subject to Garmin SDK License Agreement and Wearables
// Application Developer Agreement.
//

import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Time.Gregorian;
import Toybox.UserProfile;
import Toybox.WatchUi;

//! Shows user information about weight, height, gender, and wake time
class TestPersonalitySectionOneView extends WatchUi.View {
    private var _weightPrefixStr as String;
    private var _weightUnitsStr as String;
    private var _heightPrefixStr as String;
    private var _genderPrefixStr as String;
    private var _femaleStr as String;
    private var _maleStr as String;
    private var _heightUnitsStr as String;
    private var _wakeTimePrefixStr as String;
    private var _itemNotSetStr as String;

    //! Constructor
    public function initialize() {
        View.initialize();

        _weightPrefixStr =
            WatchUi.loadResource($.Rez.Strings.WeightPrefix) as String;
        _weightUnitsStr =
            WatchUi.loadResource($.Rez.Strings.GramUnits) as String;
        _heightPrefixStr =
            WatchUi.loadResource($.Rez.Strings.HeightPrefix) as String;
        _genderPrefixStr =
            WatchUi.loadResource($.Rez.Strings.GenderSpecifierPrefix) as String;
        _femaleStr = WatchUi.loadResource($.Rez.Strings.GenderFemale) as String;
        _maleStr = WatchUi.loadResource($.Rez.Strings.GenderMale) as String;
        _heightUnitsStr = WatchUi.loadResource($.Rez.Strings.CMUnits) as String;
        _wakeTimePrefixStr =
            WatchUi.loadResource($.Rez.Strings.WakeTimePrefix) as String;
        _itemNotSetStr =
            WatchUi.loadResource($.Rez.Strings.ItemNotSet) as String;
    }

    //! Load your resources here
    //! @param dc Device context
    public function onLayout(dc as Dc) as Void {
        setLayout($.Rez.Layouts.SectionOneLayout(dc));
    }

    //! Update the view
    //! @param dc Device Context
    public function onUpdate(dc as Dc) as Void {
        var profile = UserProfile.getProfile();

        var string = _weightPrefixStr;
        var weight = profile.weight;
        if (weight != null) {
            string += weight + _weightUnitsStr;
        } else {
            string += _itemNotSetStr;
        }
        (findDrawableById("WeightLabel") as Text).setText(string);

        string = _genderPrefixStr;
        var gender = profile.gender;
        if (gender != null) {
            if (gender == UserProfile.GENDER_FEMALE) {
                string += _femaleStr;
            } else {
                string += _maleStr;
            }
        } else {
            string += _itemNotSetStr;
        }
        (findDrawableById("GenderLabel") as Text).setText(string);

        string = _heightPrefixStr;
        var height = profile.height;
        if (height != null) {
            string += height + _heightUnitsStr;
        } else {
            string += _itemNotSetStr;
        }
        (findDrawableById("HeightLabel") as Text).setText(string);

        string = _wakeTimePrefixStr;
        var wakeTime = profile.wakeTime;
        if (wakeTime != null) {
            var wakeTimeValue = wakeTime.value();
            var hours = wakeTime.divide(Gregorian.SECONDS_PER_HOUR).value();
            var minutes =
                (wakeTimeValue - hours * Gregorian.SECONDS_PER_HOUR) /
                Gregorian.SECONDS_PER_MINUTE;
            var seconds =
                wakeTimeValue -
                hours * Gregorian.SECONDS_PER_HOUR -
                minutes * Gregorian.SECONDS_PER_MINUTE;
            string +=
                hours.format("%02u") +
                ":" +
                minutes.format("%02u") +
                ":" +
                seconds.format("%02u");
        } else {
            string += _itemNotSetStr;
        }
        (findDrawableById("WakeTimeLabel") as Text).setText(string);

        View.onUpdate(dc);
    }
}
