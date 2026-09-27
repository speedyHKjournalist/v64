(module
  (type $t0 (func (param i32)))
  (type $t1 (func (param i32 i32 i32) (result i32)))
  (type $t2 (func))
  (type $t3 (func (result i32)))
  (type $t4 (func (param i32) (result i32)))
  (import "e" "ir_sti_finish" (func $e.ir_sti_finish (type $t0)))
  (import "e" "ir_enter_checked" (func $e.ir_enter_checked (type $t1)))
  (import "e" "ir_admission_barrier" (func $e.ir_admission_barrier (type $t2)))
  (import "e" "ir_sti_check" (func $e.ir_sti_check (type $t3)))
  (import "e" "ir_sti_no_pending_irq" (func $e.ir_sti_no_pending_irq (type $t3)))
  (import "e" "ir_sti_finish_continue" (func $e.ir_sti_finish_continue (type $t4)))
  (import "e" "ir_hlt" (func $e.ir_hlt (type $t3)))
  (import "e" "ir_sti_finish_link" (func $e.ir_sti_finish_link (type $t0)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t0) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32) (local $l12 i32) (local $l13 i32) (local $l14 i32) (local $l15 i32) (local $l16 i32) (local $l17 i32) (local $l18 i32) (local $l19 i32)
    (local.set $l1
      (i32.const 0))
    (if $I0
      (local.get $p0)
      (then
        (if $I1
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (if $I2
      (i32.eqz
        (call $e.ir_enter_checked
          (i32.const 4096)
          (i32.const 0)
          (i32.const 1)))
      (then
        (if $I3
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (local.set $l2
      (i32.const 0))
    (local.set $l3
      (i32.const 256))
    (if $I4
      (local.get $p0)
      (then
        (if $I5
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (local.set $l4
      (i32.load
        (i32.const 68)))
    (local.set $l5
      (i32.load
        (i32.const 72)))
    (local.set $l6
      (i32.load
        (i32.const 76)))
    (local.set $l7
      (i32.load
        (i32.const 80)))
    (local.set $l8
      (i32.load
        (i32.const 84)))
    (local.set $l9
      (i32.load
        (i32.const 88)))
    (local.set $l10
      (i32.load
        (i32.const 92)))
    (local.set $l11
      (i32.load
        (i32.const 120)))
    (local.set $l12
      (i32.load
        (i32.const 100)))
    (local.set $l13
      (i32.load
        (i32.const 104)))
    (local.set $l14
      (i32.load
        (i32.const 112)))
    (local.set $l15
      (i32.load
        (i32.const 96)))
    (local.set $l16
      (i32.const 0))
    (if $I6
      (i32.and
        (i32.lt_u
          (local.get $l3)
          (i32.const 3))
        (i32.eqz
          (local.get $l1)))
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
                (local.get $l16))
              (local.get $l2))
            (i32.load
              (i32.const 664))))
        (local.set $l2
          (i32.add
            (i32.const 0)
            (local.get $l16)))
        (if $I7
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (local.set $l3
      (i32.sub
        (local.get $l3)
        (i32.const 3)))
    (if $I8
      (i32.eqz
        (i32.or
          (i32.eqz
            (i32.load8_u
              (i32.const 800)))
          (i32.and
            (i32.eqz
              (i32.load8_u
                (i32.const 612)))
            (i32.eqz
              (i32.and
                (i32.load
                  (i32.const 120))
                (i32.const 131072))))))
      (then
        (call $e.ir_admission_barrier)
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
                (local.get $l16))
              (local.get $l2))
            (i32.load
              (i32.const 664))))
        (local.set $l2
          (i32.add
            (i32.const 0)
            (local.get $l16)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4097)))))
    (local.set $l17
      (call $e.ir_sti_check))
    (if $I9
      (i32.eq
        (local.get $l17)
        (i32.const 2))
      (then
        (if $I10
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (if $I11
      (i32.eq
        (local.get $l17)
        (i32.const 3))
      (then
        (if $I12
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (if $I13
      (i32.eq
        (local.get $l17)
        (i32.const 4))
      (then
        (if $I14
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (if $I15
      (i32.ne
        (local.get $l17)
        (i32.const 0))
      (then
        (unreachable)))
    (local.set $l1
      (i32.add
        (local.get $l1)
        (i32.const 1)))
    (local.set $l18
      (i32.and
        (local.get $l11)
        (i32.const -513)))
    (local.set $l11
      (i32.const 1))
    (local.set $l19
      (i32.const 512))
    (local.set $l18
      (i32.or
        (local.get $l18)
        (local.get $l19)))
    (local.set $l19
      (i32.const 42424242))
    (call $e.ir_sti_no_pending_irq)
    (local.set $l1
      (i32.const 0))
    (if $I16
      (i32.eqz)
      (then
        (call $e.ir_admission_barrier)
        (i32.store
          (i32.const 64)
          (local.get $l19))
        (i32.store
          (i32.const 68)
          (local.get $l4))
        (i32.store
          (i32.const 72)
          (local.get $l5))
        (i32.store
          (i32.const 76)
          (local.get $l6))
        (i32.store
          (i32.const 80)
          (local.get $l7))
        (i32.store
          (i32.const 84)
          (local.get $l8))
        (i32.store
          (i32.const 88)
          (local.get $l9))
        (i32.store
          (i32.const 92)
          (local.get $l10))
        (i32.store
          (i32.const 104)
          (local.get $l13))
        (i32.store
          (i32.const 120)
          (local.get $l18))
        (i32.store
          (i32.const 112)
          (local.get $l14))
        (i32.store
          (i32.const 96)
          (local.get $l15))
        (i32.store
          (i32.const 100)
          (local.get $l12))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4097)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4102)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 2)
                (local.get $l16))
              (local.get $l2))
            (i32.load
              (i32.const 664))))
        (local.set $l2
          (i32.add
            (i32.const 2)
            (local.get $l16)))
        (local.set $l17
          (call $e.ir_sti_finish_continue
            (local.get $l11)))
        (if $I17
          (i32.eq
            (local.get $l17)
            (i32.const 2))
          (then
            (if $I18
              (local.get $l1)
              (then
                (call $e.ir_sti_finish
                  (local.get $l1))))
            (return)))
        (if $I19
          (i32.eq
            (local.get $l17)
            (i32.const 3))
          (then
            (if $I20
              (local.get $l1)
              (then
                (call $e.ir_sti_finish
                  (local.get $l1))))
            (return)))
        (if $I21
          (i32.eq
            (local.get $l17)
            (i32.const 4))
          (then
            (if $I22
              (local.get $l1)
              (then
                (call $e.ir_sti_finish
                  (local.get $l1))))
            (return)))
        (if $I23
          (i32.ne
            (local.get $l17)
            (i32.const 0))
          (then
            (unreachable)))))
    (local.set $l11
      (i32.const 2))
    (local.set $l16
      (i32.const 53535353))
    (call $e.ir_admission_barrier)
    (i32.store
      (i32.const 64)
      (local.get $l16))
    (i32.store
      (i32.const 68)
      (local.get $l4))
    (i32.store
      (i32.const 72)
      (local.get $l5))
    (i32.store
      (i32.const 76)
      (local.get $l6))
    (i32.store
      (i32.const 80)
      (local.get $l7))
    (i32.store
      (i32.const 84)
      (local.get $l8))
    (i32.store
      (i32.const 88)
      (local.get $l9))
    (i32.store
      (i32.const 92)
      (local.get $l10))
    (i32.store
      (i32.const 104)
      (local.get $l13))
    (i32.store
      (i32.const 120)
      (local.get $l18))
    (i32.store
      (i32.const 112)
      (local.get $l14))
    (i32.store
      (i32.const 96)
      (local.get $l15))
    (i32.store
      (i32.const 100)
      (local.get $l12))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4107)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4107)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l11))
          (local.get $l2))
        (i32.load
          (i32.const 664))))
    (local.set $l2
      (i32.add
        (i32.const 1)
        (local.get $l11)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4108)))
    (local.set $l17
      (call $e.ir_hlt))
    (if $I24
      (i32.eq
        (local.get $l17)
        (i32.const 2))
      (then
        (if $I25
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (if $I26
      (i32.eq
        (local.get $l17)
        (i32.const 4))
      (then
        (if $I27
          (local.get $l1)
          (then
            (call $e.ir_sti_finish
              (local.get $l1))))
        (return)))
    (unreachable)
    (i32.store
      (i32.const 64)
      (local.get $l16))
    (i32.store
      (i32.const 68)
      (local.get $l4))
    (i32.store
      (i32.const 72)
      (local.get $l5))
    (i32.store
      (i32.const 76)
      (local.get $l6))
    (i32.store
      (i32.const 80)
      (local.get $l7))
    (i32.store
      (i32.const 84)
      (local.get $l8))
    (i32.store
      (i32.const 88)
      (local.get $l9))
    (i32.store
      (i32.const 92)
      (local.get $l10))
    (i32.store
      (i32.const 104)
      (local.get $l13))
    (i32.store
      (i32.const 120)
      (local.get $l18))
    (i32.store
      (i32.const 112)
      (local.get $l14))
    (i32.store
      (i32.const 96)
      (local.get $l15))
    (i32.store
      (i32.const 100)
      (local.get $l12))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4107)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4107)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l11))
          (local.get $l2))
        (i32.load
          (i32.const 664))))
    (local.set $l2
      (i32.add
        (i32.const 1)
        (local.get $l11)))
    (if $I28
      (local.get $l1)
      (then
        (call $e.ir_sti_finish_link
          (local.get $l1))))
    (return)))
