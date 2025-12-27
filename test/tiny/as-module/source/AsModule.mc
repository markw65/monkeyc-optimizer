import Toybox.Lang;
import Toybox.Test;

(:test)
function testModuleLookup(logger as Logger) as Boolean {
  var appId = Rez.Strings.AppName;
  return appId == test1(0) && appId == test2(0);
}

(:typecheck(false))
function test1(index as Number) as ResourceId {
  var resourceSymbols = [:AppName];

  return Rez.Strings[resourceSymbols[index]];
}

(:typecheck(false)) // sdk-8.4 reports an error for the return type
function test2(index as Number) as ResourceId {
  var resourceSymbols = [:AppName];

  return (Rez.Strings as Rez.Strings)[resourceSymbols[index]];
}
