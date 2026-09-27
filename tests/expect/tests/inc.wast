(module
  (type $t0 (func (param i32 i32 i32) (result i32)))
  (type $t1 (func (result i32)))
  (type $t2 (func))
  (type $t3 (func (param i32)))
  (import "e" "ir_enter_checked" (func $e.ir_enter_checked (type $t0)))
  (import "e" "ir_read_cf" (func $e.ir_read_cf (type $t1)))
  (import "e" "ir_request_poll_exit" (func $e.ir_request_poll_exit (type $t2)))
  (import "e" "ir_admission_barrier" (func $e.ir_admission_barrier (type $t2)))
  (import "e" "ir_hlt" (func $e.ir_hlt (type $t1)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t3) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32)
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
      (i32.load
        (i32.const 64)))
    (local.set $l4
      (i32.load
        (i32.const 120)))
    (local.set $l5
      (i32.and
        (i32.shr_u
          (call $e.ir_read_cf)
          (i32.const 0))
        (i32.const 1)))
    (local.set $l6
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
                (local.get $l6))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l6)))
        (call $e.ir_request_poll_exit)
        (return)))
    (local.set $l2
      (i32.sub
        (local.get $l2)
        (i32.const 2)))
    (local.set $l7
      (i32.const 1))
    (local.set $l8
      (i32.add
        (local.get $l3)
        (local.get $l7)))
    (local.set $l7
      (i32.const 31))
    (local.set $l4
      (i32.or
        (i32.and
          (local.get $l4)
          (i32.const -2))
        (local.get $l5)))
    (local.set $l9
      (i32.const 2260))
    (call $e.ir_admission_barrier)
    (i32.store
      (i32.const 64)
      (local.get $l8))
    (i32.store
      (i32.const 104)
      (local.get $l3))
    (i32.store
      (i32.const 120)
      (local.get $l4))
    (i32.store
      (i32.const 112)
      (local.get $l8))
    (i32.store
      (i32.const 96)
      (local.get $l7))
    (i32.store
      (i32.const 100)
      (local.get $l9))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4097)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4097)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l6))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l6)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4098)))
    (local.set $l10
      (call $e.ir_hlt))
    (if $I4
      (i32.eq
        (local.get $l10)
        (i32.const 2))
      (then
        (return)))
    (if $I5
      (i32.eq
        (local.get $l10)
        (i32.const 4))
      (then
        (return)))
    (unreachable)
    (i32.store
      (i32.const 64)
      (local.get $l8))
    (i32.store
      (i32.const 104)
      (local.get $l3))
    (i32.store
      (i32.const 120)
      (local.get $l4))
    (i32.store
      (i32.const 112)
      (local.get $l8))
    (i32.store
      (i32.const 96)
      (local.get $l7))
    (i32.store
      (i32.const 100)
      (local.get $l9))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4097)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4097)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l6))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l6)))
    (return)))
