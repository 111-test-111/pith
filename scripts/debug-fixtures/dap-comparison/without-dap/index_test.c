#include "index.h"

#include <assert.h>
#include <stdio.h>

int main(void) {
    ReceiptIndex index;
    index_init(&index);

    /* These three keys share an initial hash slot (33). */
    assert(index_record(&index, "receipt-94", 0) == 1);
    assert(index_record(&index, "receipt-105", 1) == 1);
    assert(index_record(&index, "receipt-120", 2) == 1);
    index_retire_before(&index, 1);

    /* A retired slot must not end the probe chain for still-live receipts. */
    assert(!index_contains(&index, "receipt-94"));
    assert(index_contains(&index, "receipt-105"));
    assert(index_contains(&index, "receipt-120"));
    assert(!index_contains(&index, "receipt-absent"));

    assert(index_record(&index, "receipt-94", 3) == 1);
    assert(index_contains(&index, "receipt-94"));
    assert(index_contains(&index, "receipt-105"));
    assert(index_contains(&index, "receipt-120"));
    assert(index.live == 3 && index.retired == 0);
    puts("receipt index regression verified");
    return 0;
}
