(:foo)
class A {
}
// @expect "Class $.B's inheritance graph contains a cycle including $.A"
(:foo)
class B extends A {
}
(:bar)
class B {
}
(:bar)
class A extends B {
}
