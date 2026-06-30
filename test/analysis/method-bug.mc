import Toybox.Lang;

class Bug {
    hidden var mcallbackResult as
        (Method
            (
                szLicenseType as String,
                szLicenseExpiryDateTime as String,
                szLicenseException as String
            )
        )?;

    function initialize() {
        mcallbackResult = null;
    }
}
