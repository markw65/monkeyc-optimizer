import Toybox.Application;
import Toybox.Lang;

module TestBarrel {
  (:release)
  const Konstant = 2;
  (:debug)
  const Konstant = 1;

  function foo() as Number {
    return Rez.Styles.foobar.x;
  }
  (:Foo)
  module FooMod {
    class Foo {
      function foo() {
        return 42;
      }
      function bar() {
        return foo();
      }
    }
  }
  (:Bar)
  module BarMod {
    class Bar {
      function foo() {
        return 36;
      }
      function bar() {
        return foo();
      }
    }
  }
}
