(module
  (type $t0 (func (param i32 i32 i32) (result i32)))
  (type $t1 (func))
  (type $t2 (func (param i32)))
  (import "e" "ir_enter_checked" (func $e.ir_enter_checked (type $t0)))
  (import "e" "ir_request_poll_exit" (func $e.ir_request_poll_exit (type $t1)))
  (import "e" "ir_request_link" (func $e.ir_request_link (type $t1)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t2) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32)
    (if $I0
      (local.get $p0)
      (then
        (return)))
    (if $I1
      (i32.eqz
        (call $e.ir_enter_checked
          (i32.const 4096)
          (i32.const 0)
          (i32.const 1)))
      (then
        (return)))
    (local.set $l1
      (i32.const 0))
    (local.set $l2
      (i32.const 256))
    (if $I2
      (local.get $p0)
      (then
        (return)))
    (local.set $l3
      (i32.const 0))
    (if $I3
      (i32.eqz
        (local.get $l2))
      (then
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4096)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4096)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 0)
                (local.get $l3))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l3)))
        (call $e.ir_request_poll_exit)
        (return)))
    (local.set $l2
      (i32.sub
        (local.get $l2)
        (i32.const 1)))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4096)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 8175)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l3))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l3)))
    (call $e.ir_request_link)
    (return)))
