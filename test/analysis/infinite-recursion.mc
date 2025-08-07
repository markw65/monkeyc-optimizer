import Toybox.Lang;
typedef Tuple1 as [Number, Array<Tuple1>?];
typedef Tuple2 as [Number, Array<Tuple2>?];

// triggers infinite recursion in subtypeOf unless we're careful
var x as Tuple1 or Tuple2 = [42, null] as [Number, Null];

typedef M1 as (Method(x as Tuple1) as Number);
typedef M2 as (Method(x as Tuple2) as Number);

// triggers infinite recursion in intersection unless we're careful
var m as M1 or M2 or Null = null;
