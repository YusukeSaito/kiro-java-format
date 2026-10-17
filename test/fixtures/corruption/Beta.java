import java.util.Optional;
import java.util.function.Function;
import java.util.Collections;
import java.util.LinkedList;
import java.util.Deque;
import java.util.concurrent.TimeUnit;

public class Beta {
  private final Deque<String> queue = new LinkedList<>();

        public void push(String value) {
    queue.addFirst(value);
}

  public Optional<String> peek(){
            return Optional.ofNullable(queue.peekFirst());
    }

public <R> Optional<R> peekAs(Function<String, R> mapper) {
      return peek().map(mapper);
  }
}
