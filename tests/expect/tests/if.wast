(module
  (type $t0 (func (param i32 i32 i32) (result i32)))
  (type $t1 (func))
  (type $t2 (func (result i32)))
  (type $t3 (func (param i32)))
  (import "e" "ir_enter_checked" (func $e.ir_enter_checked (type $t0)))
  (import "e" "ir_request_poll_exit" (func $e.ir_request_poll_exit (type $t1)))
  (import "e" "ir_admission_barrier" (func $e.ir_admission_barrier (type $t1)))
  (import "e" "ir_hlt" (func $e.ir_hlt (type $t2)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t3) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32) (local $l12 i32) (local $l13 i32) (local $l14 i32) (local $l15 i32) (local $l16 i32) (local $l17 i32) (local $l18 i32) (local $l19 i32)
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
    (block $B3
      (block $B4
        (local.set $l3
          (i32.load
            (i32.const 64)))
        (local.set $l4
          (i32.load
            (i32.const 68)))
        (local.set $l5
          (i32.load
            (i32.const 76)))
        (local.set $l6
          (i32.load
            (i32.const 120)))
        (local.set $l7
          (i32.const 1))
        (local.set $l8
          (i32.const 0))
        (if $I5
          (i32.lt_u
            (local.get $l2)
            (i32.const 6))
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
                    (local.get $l8))
                  (local.get $l1))
                (i32.load
                  (i32.const 664))))
            (local.set $l1
              (i32.add
                (i32.const 0)
                (local.get $l8)))
            (call $e.ir_request_poll_exit)
            (return)))
        (local.set $l2
          (i32.sub
            (local.get $l2)
            (i32.const 6)))
        (local.set $l9
          (i32.const 5))
        (local.set $l10
          (i32.sub
            (local.get $l3)
            (local.get $l9)))
        (local.set $l11
          (i32.and
            (i32.lt_u
              (local.get $l3)
              (local.get $l9))
            (i32.const 1)))
        (local.set $l9
          (i32.xor
            (local.get $l3)
            (local.get $l9)))
        (local.set $l12
          (i32.xor
            (local.get $l3)
            (local.get $l10)))
        (local.set $l13
          (i32.and
            (i32.shr_u
              (i32.and
                (local.get $l12)
                (local.get $l9))
              (i32.const 31))
            (i32.const 1)))
        (local.set $l14
          (i32.and
            (i32.eq
              (local.get $l10)
              (local.get $l8))
            (i32.const 1)))
        (local.set $l15
          (i32.and
            (i32.shr_u
              (local.get $l10)
              (i32.const 31))
            (i32.const 1)))
        (local.set $l16
          (i32.const 31))
        (local.set $l9
          (i32.const -2147481387))
        (local.set $l17
          (i32.and
            (i32.xor
              (local.get $l15)
              (local.get $l13))
            (i32.const 1)))
        (local.set $l17
          (i32.and
            (i32.or
              (local.get $l14)
              (local.get $l17))
            (i32.const 1)))
        (local.set $l17
          (i32.and
            (i32.xor
              (local.get $l17)
              (local.get $l7))
            (i32.const 1)))
        (if $I6
          (local.get $l17)
          (then
            (br $B4)))
        (local.set $l9
          (i32.const 1))
        (local.set $l10
          (i32.add
            (local.get $l4)
            (local.get $l9)))
        (local.set $l6
          (i32.or
            (i32.and
              (local.get $l6)
              (i32.const -2))
            (local.get $l11)))
        (local.set $l9
          (i32.const 2260))
        (local.set $l12
          (i32.const 3))
        (local.set $l18
          (local.get $l12))
        (local.set $l12
          (local.get $l10))
        (local.set $l19
          (local.get $l10))
        (local.set $l10
          (local.get $l9))
        (local.set $l9
          (local.get $l6))
        (local.set $l6
          (local.get $l4))
        (local.set $l4
          (local.get $l19))
        (br $B3))
      (local.set $l12
        (i32.const 2))
      (local.set $l18
        (local.get $l12))
      (local.set $l12
        (local.get $l10))
      (local.set $l10
        (local.get $l9))
      (local.set $l9
        (local.get $l6))
      (local.set $l6
        (local.get $l3)))
    (local.set $l6
      (i32.const 1))
    (local.set $l10
      (i32.add
        (local.get $l5)
        (local.get $l6)))
    (local.set $l6
      (i32.or
        (i32.and
          (local.get $l9)
          (i32.const -2))
        (local.get $l11)))
    (local.set $l9
      (i32.const 2260))
    (call $e.ir_admission_barrier)
    (i32.store
      (i32.const 68)
      (local.get $l4))
    (i32.store
      (i32.const 76)
      (local.get $l10))
    (i32.store
      (i32.const 104)
      (local.get $l5))
    (i32.store
      (i32.const 120)
      (local.get $l6))
    (i32.store
      (i32.const 112)
      (local.get $l10))
    (i32.store
      (i32.const 96)
      (local.get $l16))
    (i32.store
      (i32.const 100)
      (local.get $l9))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4103)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4103)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l18))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l18)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4104)))
    (local.set $l19
      (call $e.ir_hlt))
    (if $I7
      (i32.eq
        (local.get $l19)
        (i32.const 2))
      (then
        (return)))
    (if $I8
      (i32.eq
        (local.get $l19)
        (i32.const 4))
      (then
        (return)))
    (unreachable)
    (i32.store
      (i32.const 68)
      (local.get $l4))
    (i32.store
      (i32.const 76)
      (local.get $l10))
    (i32.store
      (i32.const 104)
      (local.get $l5))
    (i32.store
      (i32.const 120)
      (local.get $l6))
    (i32.store
      (i32.const 112)
      (local.get $l10))
    (i32.store
      (i32.const 96)
      (local.get $l16))
    (i32.store
      (i32.const 100)
      (local.get $l9))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4103)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4103)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l18))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l18)))
    (return)))
