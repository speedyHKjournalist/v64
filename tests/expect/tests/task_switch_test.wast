(module
  (type $t0 (func (param i32 i32 i32) (result i32)))
  (type $t1 (func))
  (type $t2 (func (result i32)))
  (type $t3 (func (param i32 i32 i32 i32) (result i64)))
  (type $t4 (func (param i32)))
  (import "e" "ir_enter_checked" (func $e.ir_enter_checked (type $t0)))
  (import "e" "ir_request_poll_exit" (func $e.ir_request_poll_exit (type $t1)))
  (import "e" "ir_admission_barrier" (func $e.ir_admission_barrier (type $t1)))
  (import "e" "ir_fpu_guard" (func $e.ir_fpu_guard (type $t2)))
  (import "e" "ir_x87_op" (func $e.ir_x87_op (type $t3)))
  (import "e" "ir_hlt" (func $e.ir_hlt (type $t2)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t4) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 f64) (local $l9 f64) (local $l10 f64) (local $l11 i32)
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
      (i32.lt_u
        (local.get $l2)
        (i32.const 2))
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
        (i32.const 2)))
    (if $I4
      (i32.and
        (i32.load
          (i32.const 580))
        (i32.const 12))
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
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4098)))
        (call $e.ir_admission_barrier)
        (local.set $l4
          (call $e.ir_fpu_guard))
        (if $I5
          (i32.ne
            (local.get $l4)
            (i32.const 0))
          (then
            (if $I6
              (i32.ne
                (local.get $l4)
                (i32.const 2))
              (then
                (unreachable)))
            (return)))))
    (block $B7
      (block $B8
        (br_if $B8
          (i32.eqz
            (i32.load8_u
              (i32.const 1352))))
        (local.set $l4
          (i32.load8_u
            (i32.const 1032)))
        (local.set $l5
          (i32.load8_u
            (i32.const 816)))
        (local.set $l6
          (i32.and
            (i32.load
              (i32.const 1344))
            (i32.xor
              (local.get $l5)
              (i32.const -1))))
        (local.set $l7
          (i32.and
            (i32.add
              (local.get $l4)
              (i32.const 0))
            (i32.const 7)))
        (br_if $B8
          (i32.eqz
            (i32.and
              (i32.shr_u
                (local.get $l6)
                (local.get $l7))
              (i32.const 1))))
        (local.set $l8
          (f64.load offset=1280
            (i32.shl
              (local.get $l7)
              (i32.const 3))))
        (local.set $l7
          (i32.and
            (i32.add
              (local.get $l4)
              (i32.const 1))
            (i32.const 7)))
        (br_if $B8
          (i32.eqz
            (i32.and
              (i32.shr_u
                (local.get $l6)
                (local.get $l7))
              (i32.const 1))))
        (local.set $l9
          (f64.load offset=1280
            (i32.shl
              (local.get $l7)
              (i32.const 3))))
        (local.set $l10
          (f64.add
            (local.get $l8)
            (local.get $l9)))
        (local.set $l7
          (i32.and
            (i32.add
              (local.get $l4)
              (i32.const 1))
            (i32.const 7)))
        (local.set $l5
          (i32.or
            (local.get $l5)
            (i32.shl
              (i32.const 1)
              (local.get $l4))))
        (local.set $l4
          (i32.and
            (i32.add
              (local.get $l4)
              (i32.const 1))
            (i32.const 7)))
        (f64.store offset=1280
          (i32.shl
            (local.get $l7)
            (i32.const 3))
          (local.get $l10))
        (local.set $l11
          (i32.shl
            (i32.const 1)
            (local.get $l7)))
        (i32.store
          (i32.const 1344)
          (i32.or
            (i32.load
              (i32.const 1344))
            (local.get $l11)))
        (i32.store
          (i32.const 1348)
          (i32.or
            (i32.load
              (i32.const 1348))
            (local.get $l11)))
        (i32.store8
          (i32.const 1032)
          (local.get $l4))
        (i32.store8
          (i32.const 816)
          (local.get $l5))
        (br $B7))
      (drop
        (call $e.ir_x87_op
          (i32.const 222)
          (i32.const 193)
          (i32.const 0)
          (i32.const 0))))
    (call $e.ir_admission_barrier)
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4098)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4098)
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
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4099)))
    (local.set $l6
      (call $e.ir_hlt))
    (if $I9
      (i32.eq
        (local.get $l6)
        (i32.const 2))
      (then
        (return)))
    (if $I10
      (i32.eq
        (local.get $l6)
        (i32.const 4))
      (then
        (return)))
    (unreachable)
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4098)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4098)
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
    (return)))
