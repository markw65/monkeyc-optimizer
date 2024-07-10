(:foo)
class A {
}
(:foo)
class B extends A {
}
(:bar)
class B {
}
(:bar)
class A extends B {
}

module TestBarrel {
    class TestClass {
    }
}
class TestClass extends TestBarrel.TestClass {
}
